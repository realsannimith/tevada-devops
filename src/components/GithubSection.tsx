/**
 * "GitHub" section of the Settings dialog: connect an account (device flow with
 * a paste-a-token fallback), see who's connected, manage which repositories the
 * app can reach (GitHub App installations — all repos or a hand-picked set),
 * disconnect, and grant/revoke each saved server permission to clone.
 *
 * The token never reaches this process — main does the exchange and storage;
 * this UI only sees `GithubStatus` metadata and auth-progress events.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useServers } from '@/hooks/useServers';
import { GithubIcon } from '@/lib/brand-icons';
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  Loader2Icon,
  RefreshIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import type { GithubInstallation, GithubStatus } from '@/shared/ipc-types';

type DeviceState = { userCode: string; verificationUri: string };

/** Poll for new installations for 2 min after the install page is opened. */
const INSTALL_WATCH_INTERVAL_MS = 5_000;
const INSTALL_WATCH_MAX_TICKS = 24;

export function GithubSection() {
  const { servers } = useServers();
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [showPat, setShowPat] = useState(false);
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [serverBusy, setServerBusy] = useState<Record<string, boolean>>({});
  const [serverError, setServerError] = useState<Record<string, string>>({});
  const [installs, setInstalls] = useState<GithubInstallation[] | null>(null);
  const [installsBusy, setInstallsBusy] = useState(false);
  const [installsError, setInstallsError] = useState<string | null>(null);
  const watchTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopInstallWatch = useCallback(() => {
    if (watchTimer.current) {
      clearInterval(watchTimer.current);
      watchTimer.current = null;
    }
  }, []);

  const refreshInstallations = useCallback(async (): Promise<GithubInstallation[] | null> => {
    setInstallsBusy(true);
    setInstallsError(null);
    try {
      const r = await window.easyhost.github.installations();
      if (r.ok === false) {
        setInstallsError(r.error);
        return null;
      }
      setInstalls(r.installations);
      return r.installations;
    } finally {
      setInstallsBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    const s = await window.easyhost.github.status();
    setStatus(s);
    if (s.connected && s.account?.method === 'app') {
      // Cached copy paints instantly; a live fetch replaces it right after.
      if (s.account.installations) setInstalls(s.account.installations);
      void refreshInstallations();
    } else {
      setInstalls(null);
    }
  }, [refreshInstallations]);

  useEffect(() => {
    void refresh();
    const unsub = window.easyhost.github.onAuthEvent((e) => {
      if (e.phase === 'success') {
        setDevice(null);
        setError(null);
        void refresh();
      } else if (e.phase === 'error') {
        setDevice(null);
        setError(e.error);
      }
    });
    return () => {
      unsub();
      stopInstallWatch();
    };
  }, [refresh, stopInstallWatch]);

  // Cancel a dangling device poll when the dialog unmounts mid-flow.
  useEffect(
    () => () => {
      void window.easyhost.github.cancelDeviceFlow();
    },
    [],
  );

  async function startDeviceFlow() {
    setBusy(true);
    setError(null);
    try {
      const r = await window.easyhost.github.startDeviceFlow();
      if (r.ok === false) {
        setError(r.error);
      } else {
        setDevice({ userCode: r.userCode, verificationUri: r.verificationUri });
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancelDeviceFlow() {
    await window.easyhost.github.cancelDeviceFlow();
    setDevice(null);
  }

  async function connectWithPat() {
    if (!pat.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.easyhost.github.connectWithToken(pat);
      setStatus(next);
      setPat('');
      setShowPat(false);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^.*Error: /, '') : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      setStatus(await window.easyhost.github.disconnect());
      setServerError({});
      setInstalls(null);
      stopInstallWatch();
    } finally {
      setBusy(false);
    }
  }

  /** Open the install page (or one installation's settings) on GitHub, then
   *  watch for the repo-access change to land so the UI updates by itself. */
  async function openGithubAccessPage(installationId?: number) {
    setInstallsError(null);
    const r = await window.easyhost.github.openInstall(installationId);
    if (!r.ok) {
      setInstallsError(r.error ?? 'Could not open GitHub.');
      return;
    }
    stopInstallWatch();
    let ticks = 0;
    watchTimer.current = setInterval(() => {
      ticks += 1;
      if (ticks > INSTALL_WATCH_MAX_TICKS) {
        stopInstallWatch();
        return;
      }
      void refreshInstallations();
    }, INSTALL_WATCH_INTERVAL_MS);
  }

  async function toggleServer(serverId: string, allow: boolean) {
    setServerBusy((p) => ({ ...p, [serverId]: true }));
    setServerError((p) => ({ ...p, [serverId]: '' }));
    const r = allow
      ? await window.easyhost.github.authorizeServer(serverId)
      : await window.easyhost.github.deauthorizeServer(serverId);
    if (!r.ok) setServerError((p) => ({ ...p, [serverId]: r.error ?? 'Failed.' }));
    setServerBusy((p) => ({ ...p, [serverId]: false }));
    void refresh();
  }

  async function copyCode() {
    if (!device) return;
    await navigator.clipboard.writeText(device.userCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const account = status?.account;
  const isApp = account?.method === 'app';

  return (
    <div className="grid gap-2">
      <div className="pr-4">
        <Label>GitHub</Label>
        <p className="text-xs text-muted-foreground">
          Connect your account and choose which repositories this app — and the
          agent — can reach. Your servers can then clone them, including private
          ones, during deploys.
        </p>
      </div>

      {!status ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" /> Checking…
        </div>
      ) : device ? (
        /* Device flow in progress (first connect OR reconnect after expiry):
           show the one-time code */
        <div className="surface-panel grid gap-2 p-4 text-center">
          <p className="text-xs text-muted-foreground">
            Enter this code at{' '}
            <span className="font-mono text-ink">{device.verificationUri}</span>
            {' '}— we opened it in your browser.
          </p>
          <button
            type="button"
            onClick={copyCode}
            className="mx-auto flex items-center gap-2 rounded-md border border-border bg-secondary px-4 py-2 font-mono text-lg tracking-[0.25em] text-ink"
            title="Copy code"
          >
            {device.userCode}
            {copied ? (
              <CheckIcon className="size-4 text-success" />
            ) : (
              <CopyIcon className="size-4 text-muted-foreground" />
            )}
          </button>
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" /> Waiting for you to
            authorize on GitHub…
          </div>
          <Button variant="ghost" size="sm" onClick={cancelDeviceFlow}>
            Cancel
          </Button>
        </div>
      ) : account ? (
        <>
          {/* Expired session — refresh token ran out (≈6 months) or was revoked */}
          {account.needsReauth && (
            <div className="surface-panel flex items-center gap-3 p-3">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                Your GitHub session expired. Reconnect to keep repository access
                and server deploys working.
              </p>
              <Button variant="prominent" size="sm" onClick={startDeviceFlow} disabled={busy}>
                Reconnect
              </Button>
            </div>
          )}

          {/* Connected account card */}
          <div className="surface-panel flex items-center gap-3 p-3">
            {account.avatarUrl ? (
              <img
                src={account.avatarUrl}
                alt=""
                className="size-8 rounded-full border border-border"
              />
            ) : (
              <GithubIcon className="size-8" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold tracking-[-0.015em] text-ink">
                {account.name || account.login}
              </p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                @{account.login}
                {isApp
                  ? ' · GitHub App'
                  : account.scopes
                    ? ` · ${account.scopes}`
                    : ''}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={disconnect} disabled={busy}>
              Disconnect
            </Button>
          </div>

          {/* Repository access (GitHub App installations) */}
          {isApp && (
            <div className="pt-1">
              <div className="flex items-center gap-2">
                <p className="flex-1 text-[11px] text-muted-foreground">
                  Repository access
                </p>
                <button
                  type="button"
                  onClick={() => void refreshInstallations()}
                  className="text-muted-foreground transition-colors hover:text-ink"
                  title="Refresh repository access"
                >
                  {installsBusy ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshIcon className="size-3.5" />
                  )}
                </button>
              </div>
              {installs && installs.length > 0 ? (
                <>
                  <div className="mt-1.5 surface-panel divide-y divide-border">
                    {installs.map((inst) => (
                      <div key={inst.id} className="flex items-center gap-3 px-3 py-2.5">
                        {inst.accountAvatarUrl ? (
                          <img
                            src={inst.accountAvatarUrl}
                            alt=""
                            className="size-6 rounded-full border border-border"
                          />
                        ) : (
                          <GithubIcon className="size-6" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs text-ink">
                            {inst.accountLogin}
                            {inst.accountType === 'Organization' && (
                              <span className="text-muted-foreground"> · org</span>
                            )}
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {inst.repositorySelection === 'all'
                              ? 'All repositories'
                              : `${inst.repoCount ?? 'Selected'} selected ${
                                  inst.repoCount === 1 ? 'repository' : 'repositories'
                                }`}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void openGithubAccessPage(inst.id)}
                          title="Change which repositories this app can reach (opens GitHub)"
                        >
                          Manage
                          <ExternalLinkIcon className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => void openGithubAccessPage()}
                    className="mt-1.5 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                  >
                    Add another account or organization…
                  </button>
                </>
              ) : (
                <div className="mt-1.5 surface-panel grid gap-2 p-3">
                  <p className="text-xs text-muted-foreground">
                    {installsBusy && installs === null
                      ? 'Checking repository access…'
                      : 'No repository access yet. Install the app on your GitHub account and pick “All repositories” or just the ones you want to deploy.'}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="prominent"
                      size="sm"
                      onClick={() => void openGithubAccessPage()}
                    >
                      <GithubIcon className="size-3.5" />
                      Grant repository access
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void refreshInstallations()}
                      disabled={installsBusy}
                    >
                      I&apos;ve installed it — check again
                    </Button>
                  </div>
                </div>
              )}
              {installsError && (
                <p className="mt-1 text-[11px] text-destructive" role="alert">
                  {installsError}
                </p>
              )}
            </div>
          )}

          {/* Per-server clone permission */}
          <div className="pt-1">
            <p className="text-[11px] text-muted-foreground">Server access</p>
            <p className="pb-1.5 text-xs text-muted-foreground">
              Allowed servers get your GitHub credentials in their git credential
              store, so any <span className="font-mono">git clone</span> — yours
              or the agent&apos;s — just works.
            </p>
            {servers.length === 0 ? (
              <div className="surface-panel p-3 text-xs text-muted-foreground">
                No servers yet. Add one from the sidebar first.
              </div>
            ) : (
              <div className="surface-panel divide-y divide-border">
                {servers.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-ink">{s.name}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {serverError[s.id] ? (
                          <span className="text-destructive">{serverError[s.id]}</span>
                        ) : (
                          `${s.username}@${s.host}`
                        )}
                      </p>
                    </div>
                    {serverBusy[s.id] && (
                      <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
                    )}
                    <Switch
                      checked={account.authorizedServerIds.includes(s.id)}
                      disabled={!!serverBusy[s.id]}
                      onCheckedChange={(v) => toggleServer(s.id, v)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        /* Not connected */
        <div className="grid gap-2">
          {status.deviceFlowAvailable && !showPat ? (
            <Button
              variant="prominent"
              onClick={startDeviceFlow}
              disabled={busy}
              className="justify-center"
            >
              <GithubIcon className="size-4" />
              {busy ? 'Contacting GitHub…' : 'Connect GitHub'}
            </Button>
          ) : (
            <div className="grid gap-2">
              <Input
                type="password"
                placeholder="Personal access token (repo scope)"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && connectWithPat()}
              />
              <Button
                variant="prominent"
                onClick={connectWithPat}
                disabled={busy || !pat.trim()}
                className="justify-center"
              >
                <GithubIcon className="size-4" />
                {busy ? 'Verifying…' : 'Connect with token'}
              </Button>
            </div>
          )}
          {status.deviceFlowAvailable && (
            <button
              type="button"
              onClick={() => setShowPat((v) => !v)}
              className="justify-self-start text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            >
              {showPat ? 'Use browser sign-in instead' : 'Use a personal access token instead'}
            </button>
          )}
          {status.deviceFlowAvailable && status.githubApp && !showPat && (
            <p className="text-[11px] text-muted-foreground">
              You&apos;ll sign in on github.com, then choose which repositories —
              all of them or a hand-picked set — this app may access. You can
              change the selection on GitHub at any time.
            </p>
          )}
          {!status.deviceFlowAvailable && (
            <p className="text-[11px] text-muted-foreground">
              Tip: set <span className="font-mono">GITHUB_CLIENT_ID</span> in{' '}
              <span className="font-mono">.env</span> (a GitHub App client id)
              to enable one-click browser sign-in with per-repository access.
              Create a token at github.com → Settings → Developer settings, with{' '}
              <span className="font-mono">repo</span> scope.
            </p>
          )}
        </div>
      )}

      {error && (
        <p className={cn('text-[11px] text-destructive')} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
